#include "core/server_stats.h"
#include "util/log.h"
#include "util/time.h"
#include <string.h>

int server_stats_init(struct ServerStats* stats) {
    if (!stats) return -1;
    
    memset(stats, 0, sizeof(struct ServerStats));
    stats->start_time = get_time_ms();
    stats->last_reset_time = stats->start_time;
    
    log_info("Server statistics tracking initialized");
    return 0;
}

void server_stats_update_tick(struct ServerStats* stats, uint32_t tick_duration_us) {
    if (!stats) return;
    
    stats->total_ticks++;
    stats->tick_duration_total_us += tick_duration_us;
    
    // Track min/max tick times
    if (tick_duration_us < stats->min_tick_time_us || stats->min_tick_time_us == 0) {
        stats->min_tick_time_us = tick_duration_us;
    }
    if (tick_duration_us > stats->max_tick_time_us) {
        stats->max_tick_time_us = tick_duration_us;
    }
    
    // Calculate rolling average (last 100 ticks)
    static uint32_t tick_times[100] = {0};
    static uint16_t tick_index = 0;
    
    tick_times[tick_index] = tick_duration_us;
    tick_index = (tick_index + 1) % 100;
    
    uint64_t sum = 0;
    for (int i = 0; i < 100; i++) {
        sum += tick_times[i];
    }
    stats->avg_tick_time_us = sum / 100;
}

void server_stats_update_network(struct ServerStats* stats, 
                                 uint32_t packets_received, 
                                 uint32_t packets_sent,
                                 uint32_t bytes_received,
                                 uint32_t bytes_sent) {
    if (!stats) return;
    
    stats->total_packets_received += packets_received;
    stats->total_packets_sent += packets_sent;
    stats->total_bytes_received += bytes_received;
    stats->total_bytes_sent += bytes_sent;
}

void server_stats_update_entities(struct ServerStats* stats,
                                  uint16_t ship_count,
                                  uint16_t player_count,
                                  uint32_t projectile_count) {
    if (!stats) return;
    
    stats->current_ship_count = ship_count;
    stats->current_player_count = player_count;
    stats->current_projectile_count = projectile_count;
    
    // Track peak entity counts
    if (ship_count > stats->peak_ship_count) {
        stats->peak_ship_count = ship_count;
    }
    if (player_count > stats->peak_player_count) {
        stats->peak_player_count = player_count;
    }
    if (projectile_count > stats->peak_projectile_count) {
        stats->peak_projectile_count = projectile_count;
    }
}

void server_stats_log_summary(const struct ServerStats* stats) {
    if (!stats) return;
    
    uint32_t current_time = get_time_ms();
    uint32_t uptime_ms = current_time - stats->start_time;
    uint32_t uptime_sec = uptime_ms / 1000;
    
    log_info("📊 ═══════════════ SERVER STATISTICS ═══════════════");
    log_info("⏱️  Uptime: %u seconds (%u minutes)", uptime_sec, uptime_sec / 60);
    log_info("🔄 Simulation: %u total ticks", stats->total_ticks);
    
    if (stats->total_ticks > 0) {
        uint32_t avg_tick_ms = (stats->tick_duration_total_us / stats->total_ticks) / 1000;
        log_info("⚡ Tick Performance:");
        log_info("   Average: %u μs (%u.%u ms)", 
                stats->avg_tick_time_us, 
                stats->avg_tick_time_us / 1000, 
                (stats->avg_tick_time_us % 1000) / 100);
        log_info("   Min: %u μs, Max: %u μs", 
                stats->min_tick_time_us, stats->max_tick_time_us);
        log_info("   Target: 33,333 μs (30 Hz)");
        
        if (stats->max_tick_time_us > 35000) {
            log_warn("⚠️  Performance: Max tick time exceeds target (>35ms)");
        }
    }
    
    log_info("🌐 Network Statistics:");
    log_info("   Packets: %u received, %u sent", 
            stats->total_packets_received, stats->total_packets_sent);
    log_info("   Bytes: %u received (%.1f KB), %u sent (%.1f KB)",
            stats->total_bytes_received, stats->total_bytes_received / 1024.0f,
            stats->total_bytes_sent, stats->total_bytes_sent / 1024.0f);
    
    if (uptime_sec > 0) {
        log_info("   Rate: %.1f packets/sec, %.1f KB/sec",
                (stats->total_packets_received + stats->total_packets_sent) / (float)uptime_sec,
                (stats->total_bytes_received + stats->total_bytes_sent) / 1024.0f / (float)uptime_sec);
    }
    
    log_info("🎮 Entity Counts:");
    log_info("   Current: %u ships, %u players, %u projectiles",
            stats->current_ship_count, stats->current_player_count, stats->current_projectile_count);
    log_info("   Peak: %u ships, %u players, %u projectiles",
            stats->peak_ship_count, stats->peak_player_count, stats->peak_projectile_count);
    
    log_info("═══════════════════════════════════════════════════");
}

void server_stats_reset_counters(struct ServerStats* stats) {
    if (!stats) return;
    
    uint32_t current_time = get_time_ms();
    
    // Preserve start time but reset counters
    stats->last_reset_time = current_time;
    stats->total_ticks = 0;
    stats->tick_duration_total_us = 0;
    stats->min_tick_time_us = 0;
    stats->max_tick_time_us = 0;
    stats->avg_tick_time_us = 0;
    
    stats->total_packets_received = 0;
    stats->total_packets_sent = 0;
    stats->total_bytes_received = 0;
    stats->total_bytes_sent = 0;
    
    // Keep entity peaks but reset current counts
    stats->current_ship_count = 0;
    stats->current_player_count = 0;
    stats->current_projectile_count = 0;
    
    log_info("Server statistics counters reset");
}