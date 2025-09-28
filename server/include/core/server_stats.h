#ifndef CORE_SERVER_STATS_H
#define CORE_SERVER_STATS_H

#include <stdint.h>

// Server performance and activity statistics
struct ServerStats {
    // Timing
    uint32_t start_time;              // Server start timestamp (ms)
    uint32_t last_reset_time;         // Last stats reset timestamp (ms)
    
    // Simulation performance
    uint32_t total_ticks;             // Total simulation ticks executed
    uint64_t tick_duration_total_us;  // Cumulative tick processing time (microseconds)
    uint32_t min_tick_time_us;        // Minimum tick processing time
    uint32_t max_tick_time_us;        // Maximum tick processing time  
    uint32_t avg_tick_time_us;        // Rolling average tick time (last 100)
    
    // Network statistics
    uint32_t total_packets_received;  // Total packets received
    uint32_t total_packets_sent;      // Total packets sent
    uint32_t total_bytes_received;    // Total bytes received
    uint32_t total_bytes_sent;        // Total bytes sent
    
    // Entity statistics
    uint16_t current_ship_count;      // Current active ships
    uint16_t current_player_count;    // Current active players
    uint32_t current_projectile_count; // Current active projectiles
    uint16_t peak_ship_count;         // Peak concurrent ships
    uint16_t peak_player_count;       // Peak concurrent players
    uint32_t peak_projectile_count;   // Peak concurrent projectiles
};

// Server statistics operations
int server_stats_init(struct ServerStats* stats);
void server_stats_update_tick(struct ServerStats* stats, uint32_t tick_duration_us);
void server_stats_update_network(struct ServerStats* stats, 
                                 uint32_t packets_received, 
                                 uint32_t packets_sent,
                                 uint32_t bytes_received,
                                 uint32_t bytes_sent);
void server_stats_update_entities(struct ServerStats* stats,
                                  uint16_t ship_count,
                                  uint16_t player_count,
                                  uint32_t projectile_count);
void server_stats_log_summary(const struct ServerStats* stats);
void server_stats_reset_counters(struct ServerStats* stats);

#endif /* CORE_SERVER_STATS_H */