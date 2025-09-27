#include "admin/admin_server.h"
#include "sim/types.h"
#include "net/network.h"
#include "util/log.h"
#include "util/time.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Static buffer for JSON responses (to avoid dynamic allocation)
static char json_buffer[4096];

int admin_api_status(struct HttpResponse* resp, const struct Sim* sim,
                    const struct NetworkManager* net_mgr) {
    if (!resp || !sim) return -1;
    
    (void)net_mgr; // Unused parameter
    uint32_t current_time = get_time_ms();
    uint32_t uptime = current_time - 0; // TODO: Get actual start time
    
    int len = snprintf(json_buffer, sizeof(json_buffer),
        "{\n"
        "  \"uptime_seconds\": %u,\n"
        "  \"tick_rate\": %d,\n"
        "  \"current_tick\": %u,\n"
        "  \"player_count\": %u,\n"
        "  \"server_time\": %u,\n"
        "  \"status\": \"running\"\n"
        "}",
        uptime / 1000,
        TICK_RATE_HZ,
        sim->tick,
        sim->player_count,
        current_time
    );
    
    if (len >= (int)sizeof(json_buffer)) return -1;
    
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = json_buffer;
    resp->body_length = len;
    resp->cache_control = true;
    
    return 0;
}

int admin_api_entities(struct HttpResponse* resp, const struct Sim* sim) {
    if (!resp || !sim) return -1;
    
    // Start JSON array
    int offset = snprintf(json_buffer, sizeof(json_buffer), 
        "{\n  \"entities\": [\n");
    
    bool first = true;
    
    // Add ships
    for (uint32_t i = 0; i < sim->ship_count && offset < (int)sizeof(json_buffer) - 200; i++) {
        const struct Ship* ship = &sim->ships[i];
        
        if (!first) {
            offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset, ",\n");
        }
        first = false;
        
        offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
            "    {\n"
            "      \"id\": %u,\n"
            "      \"type\": \"ship\",\n"
            "      \"position\": {\"x\": %.2f, \"y\": %.2f},\n"
            "      \"velocity\": {\"x\": %.2f, \"y\": %.2f},\n"
            "      \"rotation\": %.3f,\n"
            "      \"angular_velocity\": %.3f,\n"
            "      \"mass\": %.1f\n"
            "    }",
            ship->id,
            (float)ship->position.x / Q16_ONE,
            (float)ship->position.y / Q16_ONE,
            (float)ship->velocity.x / Q16_ONE,
            (float)ship->velocity.y / Q16_ONE,
            (float)ship->rotation / Q16_ONE,
            (float)ship->angular_velocity / Q16_ONE,
            (float)ship->mass / Q16_ONE
        );
    }
    
    // Add players
    for (uint32_t i = 0; i < sim->player_count && offset < (int)sizeof(json_buffer) - 200; i++) {
        const struct Player* player = &sim->players[i];
        
        if (!first) {
            offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset, ",\n");
        }
        first = false;
        
        offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
            "    {\n"
            "      \"id\": %u,\n"
            "      \"type\": \"player\",\n"
            "      \"position\": {\"x\": %.2f, \"y\": %.2f},\n"
            "      \"ship_id\": %u,\n"
            "      \"health\": %u\n"
            "    }",
            player->id,
            (float)player->position.x / Q16_ONE,
            (float)player->position.y / Q16_ONE,
            player->ship_id,
            player->health
        );
    }
    
    // Add projectiles
    for (uint32_t i = 0; i < sim->projectile_count && offset < (int)sizeof(json_buffer) - 200; i++) {
        const struct Projectile* proj = &sim->projectiles[i];
        
        if (!first) {
            offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset, ",\n");
        }
        first = false;
        
        offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
            "    {\n"
            "      \"id\": %u,\n"
            "      \"type\": \"projectile\",\n"
            "      \"position\": {\"x\": %.2f, \"y\": %.2f},\n"
            "      \"velocity\": {\"x\": %.2f, \"y\": %.2f},\n"
            "      \"damage\": %u,\n"
            "      \"shooter_id\": %u\n"
            "    }",
            proj->id,
            (float)proj->position.x / Q16_ONE,
            (float)proj->position.y / Q16_ONE,
            (float)proj->velocity.x / Q16_ONE,
            (float)proj->velocity.y / Q16_ONE,
            proj->damage,
            proj->shooter_id
        );
    }
    
    // Close JSON
    offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset, "\n  ]\n}");
    
    if (offset >= (int)sizeof(json_buffer)) return -1;
    
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = json_buffer;
    resp->body_length = offset;
    resp->cache_control = true;
    
    return 0;
}

int admin_api_physics_objects(struct HttpResponse* resp, const struct Sim* sim) {
    if (!resp || !sim) return -1;
    
    // Calculate physics statistics
    uint32_t total_objects = sim->ship_count + sim->player_count + sim->projectile_count;
    uint32_t collisions_per_second = 0; // TODO: Track collision rate
    
    int len = snprintf(json_buffer, sizeof(json_buffer),
        "{\n"
        "  \"ship_count\": %u,\n"
        "  \"player_count\": %u,\n"
        "  \"projectile_count\": %u,\n"
        "  \"total_objects\": %u,\n"
        "  \"collisions_per_second\": %u,\n"
        "  \"physics_time_step\": %.6f,\n"
        "  \"world_bounds\": {\n"
        "    \"min_x\": %.1f,\n"
        "    \"min_y\": %.1f,\n"
        "    \"max_x\": %.1f,\n"
        "    \"max_y\": %.1f\n"
        "  }\n"
        "}",
        sim->ship_count,
        sim->player_count,
        sim->projectile_count,
        total_objects,
        collisions_per_second,
        (float)FIXED_DT_Q16 / Q16_ONE,
        -4096.0f, -4096.0f, 4096.0f, 4096.0f // World bounds
    );
    
    if (len >= (int)sizeof(json_buffer)) return -1;
    
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = json_buffer;
    resp->body_length = len;
    resp->cache_control = true;
    
    return 0;
}

int admin_api_network_stats(struct HttpResponse* resp, const struct NetworkManager* net_mgr) {
    if (!resp || !net_mgr) return -1;
    
    uint32_t packets_sent, packets_received, bytes_sent, bytes_received;
    float packet_loss;
    uint16_t avg_rtt;
    
    network_get_stats(net_mgr, &packets_sent, &packets_received,
                     &bytes_sent, &bytes_received, &packet_loss, &avg_rtt);
    
    int len = snprintf(json_buffer, sizeof(json_buffer),
        "{\n"
        "  \"packets_sent\": %u,\n"
        "  \"packets_received\": %u,\n"
        "  \"bytes_sent\": %u,\n"
        "  \"bytes_received\": %u,\n"
        "  \"packet_loss\": %.2f,\n"
        "  \"avg_rtt\": %u,\n"
        "  \"active_connections\": %u,\n"
        "  \"bandwidth_usage_kbps\": %.1f\n"
        "}",
        packets_sent,
        packets_received,
        bytes_sent,
        bytes_received,
        packet_loss,
        avg_rtt,
        net_mgr->reliability_mgr.active_connection_count,
        (float)net_mgr->bandwidth_used / 1024.0f
    );
    
    if (len >= (int)sizeof(json_buffer)) return -1;
    
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = json_buffer;
    resp->body_length = len;
    resp->cache_control = true;
    
    return 0;
}

int admin_api_performance(struct HttpResponse* resp, const struct Sim* sim) {
    if (!resp || !sim) return -1;
    
    // TODO: Get actual performance metrics from server context
    // For now, use placeholder values
    double avg_tick_time_us = 1200.0; // ~1.2ms average
    uint64_t max_tick_time_us = 3500;  // 3.5ms max
    double cpu_usage = 15.5;           // 15.5% CPU
    uint64_t memory_usage = 1024 * 1024 * 12; // 12MB
    uint32_t ticks_per_second = TICK_RATE_HZ;
    
    int len = snprintf(json_buffer, sizeof(json_buffer),
        "{\n"
        "  \"avg_tick_time_us\": %.1f,\n"
        "  \"max_tick_time_us\": %lu,\n"
        "  \"cpu_usage\": %.1f,\n"
        "  \"memory_usage\": %lu,\n"
        "  \"ticks_per_second\": %u,\n"
        "  \"target_tick_time_us\": %d,\n"
        "  \"performance_ratio\": %.3f\n"
        "}",
        avg_tick_time_us,
        max_tick_time_us,
        cpu_usage,
        memory_usage,
        ticks_per_second,
        TICK_DURATION_MS * 1000,
        avg_tick_time_us / (TICK_DURATION_MS * 1000.0)
    );
    
    if (len >= (int)sizeof(json_buffer)) return -1;
    
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = json_buffer;
    resp->body_length = len;
    resp->cache_control = true;
    
    return 0;
}