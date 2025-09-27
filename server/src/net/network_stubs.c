#include "net/network.h"
#include "sim/types.h"
#include "util/log.h"
#include <string.h>
#include <stdlib.h>

// Temporary stub implementations to get the admin panel working

int network_init(struct NetworkManager* net_mgr, uint16_t port) {
    if (!net_mgr) return -1;
    
    memset(net_mgr, 0, sizeof(struct NetworkManager));
    net_mgr->port = port;
    
    log_info("Network initialized (stub) on port %u", port);
    return 0;
}

void network_cleanup(struct NetworkManager* net_mgr) {
    if (!net_mgr) return;
    log_info("Network cleanup (stub)");
}

int network_process_incoming(struct NetworkManager* net_mgr, struct Sim* sim) {
    (void)net_mgr; (void)sim; // Unused
    return 0; // No packets processed
}

void network_update(struct NetworkManager* net_mgr, uint32_t current_time) {
    (void)net_mgr; (void)current_time; // Unused
}

int network_send_snapshots(struct NetworkManager* net_mgr, struct Sim* sim) {
    (void)net_mgr; (void)sim; // Unused
    return 0;
}

int network_handle_handshake(struct NetworkManager* net_mgr, 
                            const struct sockaddr_in* from_addr,
                            const struct HandshakePacket* handshake) {
    (void)net_mgr; (void)from_addr; (void)handshake; // Unused
    return 0;
}

int network_process_player_input(struct NetworkManager* net_mgr, struct Sim* sim,
                                entity_id player_id, const struct CmdPacket* cmd) {
    (void)net_mgr; (void)sim; (void)player_id; (void)cmd; // Unused
    return 0;
}

// Stub for admin panel stats
void network_get_stats(const struct NetworkManager* net_mgr, 
                      uint32_t* packets_sent, uint32_t* packets_received,
                      uint32_t* bytes_sent, uint32_t* bytes_received,
                      float* packet_loss, uint16_t* avg_rtt) {
    (void)net_mgr; // Unused
    
    if (packets_sent) *packets_sent = 42;
    if (packets_received) *packets_received = 38;
    if (bytes_sent) *bytes_sent = 2048;
    if (bytes_received) *bytes_received = 1536;
    if (packet_loss) *packet_loss = 0.01f;
    if (avg_rtt) *avg_rtt = 15;
}